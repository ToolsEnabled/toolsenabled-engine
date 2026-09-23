'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/lib/tool-registry');
const accessibility = require('../src/lib/accessibility');
const { assertValid } = require('../src/lib/schema-validator');

test('screen turn actions use the existing write tool and retain all policy annotations', () => {
  const control = registry.TOOL_REGISTRY.find(tool => tool.name === 'screen.control');
  const status = registry.TOOL_REGISTRY.find(tool => tool.name === 'screen.status');
  for (const action of ['acquire', 'screenshot', 'release']) assertValid(control.inputSchema, { action });
  assert.throws(() => assertValid(control.inputSchema, { action: 'grant' }));
  assert.throws(() => assertValid(control.inputSchema, { action: 'acquire', sessionId: 'someone-else' }));
  assert.equal(control.effect, 'local-write'); assert.equal(control.approvalEligible, false);
  assert.deepEqual(control.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.equal(status.effect, 'local-read');
  const surface = tier => registry.listTools({ agentRole: { functions: ['screen.status', 'screen.control'] }, permissionSession: { origin: 'local', tier, profile: 'workspace' } }).map(tool => tool.name);
  assert.deepEqual(surface('full').sort(), ['screen.control', 'screen.status']);
  assert.ok(!surface('confined').includes('screen.control'));
});

test('acquire, screenshot and release bind the authenticated agent and retain host guidance and images', async () => {
  const calls = [], image = Buffer.from('fixture-image');
  const screenshot = { status: 'completed', control: { ownsControl: true, idleReleaseMs: 60000 } };
  Object.defineProperty(screenshot, '__mcpImage', { value: image });
  accessibility.installAccessibilityHost({ status() {}, inspect() {}, propose() {}, navigate() {},
    screenStatus: () => ({ enabled: true, state: 'busy', retryAfterMs: 5000, nextAction: 'Wait, then check status.' }),
    screenControl: (principal, args) => { calls.push({ principal, args }); return args.action === 'screenshot' ? screenshot : { status: 'completed' }; },
  });
  const agentPrincipal = { kind: 'agent-session', sessionId: 'current', agentId: 'worker', roleId: 'role', expectedRoleRevision: 3 };
  await assert.rejects(accessibility.screenControl({ action: 'acquire' }), { code: 'ACCESSIBILITY_SESSION_REQUIRED' });
  for (const action of ['acquire', 'screenshot', 'release']) {
    const result = await accessibility.screenControl({ action }, { agentPrincipal });
    assert.equal(calls.at(-1).principal, agentPrincipal);
    if (action === 'screenshot') { assert.equal(result.__mcpImage, image); assert.equal(result.control.ownsControl, true); }
  }
  const status = await accessibility.screenStatus({}, { agentPrincipal });
  assert.equal(status.state, 'busy'); assert.equal(status.retryAfterMs, 5000);
  assert.deepEqual(calls.map(call => call.args.action), ['acquire', 'screenshot', 'release']);
});

test('MCP preserves released-turn screenshot guidance without automatic retry', async () => {
  const { toolError } = require('../src/mcp-server');
  const message = 'The previous turn ended. Take a fresh screenshot before continuing.';
  const refusal = Object.assign(new Error(message), { code: 'SCREEN_CONTROL_CHANGED' });
  let calls = 0;
  accessibility.installAccessibilityHost({ status() {}, inspect() {}, propose() {}, navigate() {},
    screenControl: () => { calls++; throw refusal; },
  });
  const agentPrincipal = { kind: 'agent-session', sessionId: 'current', agentId: 'worker', roleId: 'role', expectedRoleRevision: 3 };
  let result;
  await assert.rejects(accessibility.screenControl({ action: 'click', x: 1, y: 1 }, { agentPrincipal }), error => {
    assert.equal(error, refusal);
    result = JSON.parse(JSON.stringify(toolError(error)));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, message);
  assert.equal(result.structuredContent.error.code, 'SCREEN_CONTROL_CHANGED');
  assert.equal(result.structuredContent.error.message, message);
  assert.equal(result.structuredContent.error.taxonomy.code, 'EXTERNAL_CHANGE');
  assert.equal(result.structuredContent.error.taxonomy.classification, 'retry-after-input');
  assert.equal(result.structuredContent.error.taxonomy.retryable, false);
  assert.equal(Object.hasOwn(result.structuredContent.error.taxonomy, 'retryAfterMs'), false);
  assert.equal(require('../src/lib/error-taxonomy').decideRetry(result.structuredContent.error.taxonomy,
    { effect: 'local-write', attempt: 1 }).disposition, 'blocked');
});

test('the exact screen refusal mapping keeps terminal MCP details protected', () => {
  const { toolError } = require('../src/mcp-server');
  const privateMessage = 'Private provider diagnostic: screen contents must stay protected';
  for (const code of ['SCREEN_CONTROL_CHANGED_UNRECOGNIZED', 'INTERNAL_ERROR', 'MALFORMED_OUTPUT', 'INJECTION_DETECTED']) {
    const result = JSON.parse(JSON.stringify(toolError(Object.assign(new Error(privateMessage), {
      code, details: { privateMessage },
    }))));
    assert.equal(result.structuredContent.error.taxonomy.classification, 'terminal', code);
    assert.equal(result.structuredContent.error.taxonomy.retryable, false, code);
    assert.equal(result.structuredContent.error.message, result.structuredContent.error.taxonomy.safeSummary, code);
    assert.equal(result.content[0].text, result.structuredContent.error.taxonomy.safeSummary, code);
    assert.equal(result.structuredContent.error.details, undefined, code);
    assert.ok(!JSON.stringify(result).includes(privateMessage), code);
  }
});

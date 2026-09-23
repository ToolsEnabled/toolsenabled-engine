'use strict';
require('./lib/isolated-environment').activate('resource-registry');
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src/lib/agent-resource-control');
const registry = require('../src/lib/tool-registry');
const taxonomy = require('../src/lib/error-taxonomy');
const { validate } = require('../src/lib/schema-validator');
const principal = { kind: 'agent-session', sessionId: 'synthetic-controller-session', agentId: 'synthetic-root', roleId: 'synthetic-root-role', provider: 'claude' };
const context = { agentPrincipal: principal, agentId: principal.agentId, agentSessionId: principal.sessionId,
  agentRole: { functions: ['system.resource_status', 'system.resource_advice'], requiresDirectUserAuthorization: false },
  permissionSession: { origin: 'local', tier: 'full' } };
test.after(() => api.clearResourceHost());
test('real tool dispatcher retains authenticated session context for status and finite advice', async () => {
  const calls = [];
  // Only the app-side receiver is a stand-in here. The subject is the complete
  // registered dispatcher and its context forwarding, schema and tier checks.
  api.installResourceHost({ status(value) { assert.deepEqual(value, principal); calls.push('status'); return { ok: true, sampleId: 'sample' }; },
    advise(args, value) { assert.deepEqual(value, principal); calls.push(args); return { ok: true }; } });
  assert.equal((await registry.executeTool('system.resource_status', {}, context)).sampleId, 'sample');
  const args = { bootId: 'boot', sampleId: 'sample', provider: 'claude', decision: 'allow', launches: 2, expiresAtMs: Date.now() + 10000, reason: 'Synthetic headroom.' };
  assert.equal((await registry.executeTool('system.resource_advice', args, context)).ok, true);
  assert.deepEqual(calls, ['status', args]);
  await assert.rejects(registry.executeTool('system.resource_status', {}, { permissionSession: context.permissionSession }), { code: 'RESOURCE_CONTROLLER_REQUIRED' });
  await assert.rejects(registry.executeTool('system.resource_advice', args, { ...context, permissionSession: { origin: 'remote', tier: 'guarded' } }), { code: 'PERMISSION_EFFECT_REFUSED' });
  await assert.rejects(registry.executeTool('system.resource_status', {}, { ...context, agentRole: undefined }), { code: 'ROLE_POLICY_REQUIRED' });
  await assert.rejects(registry.executeTool('system.resource_advice', args, { ...context, agentRole: { functions: [] } }), { code: 'TOOL_NOT_ENABLED' });
  assert.deepEqual(calls, ['status', args], 'refused role/tier calls never reach the receiver');
});
test('advice schema refuses caller-asserted authority and unbounded credit', () => {
  const schema = registry.getTool('system.resource_advice').inputSchema;
  const args = { bootId: 'boot', sampleId: 'sample', provider: 'claude', decision: 'allow', launches: 2, expiresAtMs: 100, reason: 'Measured.' };
  assert.deepEqual(validate(schema, args), []);
  assert.ok(validate(schema, { ...args, principal }).length > 0);
  assert.ok(validate(schema, { ...args, launches: 1001 }).length > 0);
  assert.ok(validate(schema, { ...args, reason: 'x'.repeat(501) }).length > 0);
});
test('missing controller identity requires input instead of a timed resource-pressure retry', () => {
  assert.throws(() => api.resourceStatus({}, {}), error => {
    assert.equal(error.code, 'RESOURCE_CONTROLLER_REQUIRED');
    const failure = taxonomy.publicFailure(taxonomy.adaptToolError(error));
    assert.equal(failure.code, 'INPUT_REQUIRED');
    assert.equal(failure.retryable, false);
    assert.equal(Object.hasOwn(failure, 'retryAfterMs'), false);
    return true;
  });
  const pressure = taxonomy.publicFailure(taxonomy.adaptToolError(Object.assign(new Error('pressure'), { code: 'RESOURCE_PRESSURE' })));
  assert.equal(pressure.code, 'RESOURCE_PRESSURE');
  assert.equal(pressure.retryable, true);
});
test('an old resource sample requires a fresh observation instead of a timed pressure retry', () => {
  const source = Object.assign(new Error('The resource sample is no longer current.'), { code: 'RESOURCE_ADVICE_STALE' });
  const failure = taxonomy.publicFailure(taxonomy.adaptToolError(source));
  assert.equal(failure.code, 'STALE_DATA');
  assert.equal(failure.retryable, false);
  assert.equal(Object.hasOwn(failure, 'retryAfterMs'), false);
});

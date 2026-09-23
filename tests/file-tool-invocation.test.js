'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const contexts = require('../src/lib/file-tool-context');
const capabilityReaders = require('../src/lib/file-tool-capabilities');

test('kernel readers accept the surface-issued capability and cannot revive its retired identity', async t => {
  const parent = scope(t);
  const call = begin(t, parent, 'host.read_file');
  assert.equal(capabilityReaders.requireFileToolContext(parent), parent.binding);
  assert.equal(capabilityReaders.consumeFileToolInvocation(call.capability, parent, call.toolName).toolName, call.toolName);
  assert.throws(() => capabilityReaders.requireFileToolContext({ ...parent }), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  assert.throws(() => capabilityReaders.registerFileToolContext(parent), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  await contexts.retireFileToolContext(parent);
  assert.throws(() => capabilityReaders.registerFileToolContext(parent), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  assert.throws(() => capabilityReaders.assertFileToolInvocationCurrent(call.capability, parent, call.toolName), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
});

function scope(t, sessionId = 'accepted-session') {
  const value = contexts.createFileToolContext({ scopeKind: 'owner-host-session', agentId: 'worker', sessionId });
  t.after(() => contexts.retireFileToolContext(value, 'test-finished'));
  return value;
}

function begin(t, parent, toolName = 'repo.read_file') {
  const invocationId = `invocation-${randomUUID()}`;
  const capability = contexts.beginFileToolInvocation(parent, { invocationId, toolName });
  t.after(() => contexts.endFileToolInvocation(capability));
  return { capability, invocationId, toolName };
}

test('one invocation describes the accepted session without changing durable scope identity', t => {
  const parent = scope(t, 'host-accepted-not-a-canonical-run');
  const originalBinding = JSON.stringify(parent.binding);
  const call = begin(t, parent);
  const metadata = contexts.consumeFileToolInvocation(call.capability, parent, call.toolName);
  assert.deepEqual(metadata, {
    schemaVersion: 1, invocationId: call.invocationId, toolName: call.toolName,
    runtimeScopeId: parent.binding.runtimeScopeId,
    sessionAssociation: { kind: 'owner-host-accepted-session', sessionId: 'host-accepted-not-a-canonical-run' }
  });
  assert.ok(Object.isFrozen(metadata));
  assert.ok(Object.isFrozen(metadata.sessionAssociation));
  assert.throws(() => { metadata.sessionAssociation.sessionId = 'forged'; }, TypeError);
  assert.equal(contexts.assertFileToolInvocationCurrent(call.capability, parent, call.toolName), metadata);
  assert.equal(JSON.stringify(parent.binding), originalBinding);
  assert.equal(Object.hasOwn(parent.binding, 'sessionId'), false);
  for (const field of ['canonicalLaunchId', 'runId', 'laneId', 'rosterRef']) assert.equal(parent.binding[field], null);
});

test('a serialized call trace, copied capability and foreign scope cannot authorize a call', t => {
  const parent = scope(t, 'one');
  const other = scope(t, 'two');
  const call = begin(t, parent);
  for (const wrongParent of [other, { ...parent }]) {
    assert.throws(() => contexts.consumeFileToolInvocation(call.capability, wrongParent, call.toolName));
  }
  assert.throws(() => contexts.consumeFileToolInvocation(call.capability, parent, 'repo.write_file'));
  const metadata = contexts.consumeFileToolInvocation(call.capability, parent, call.toolName);
  for (const copied of [undefined, { ...call.capability }, JSON.parse(JSON.stringify(call.capability)), metadata, JSON.parse(JSON.stringify(metadata))]) {
    assert.throws(() => contexts.consumeFileToolInvocation(copied, parent, call.toolName), { code: 'REPO_FILE_INVOCATION_INVALID' });
    assert.throws(() => contexts.assertFileToolInvocationCurrent(copied, parent, call.toolName), { code: 'REPO_FILE_INVOCATION_INVALID' });
  }
  assert.throws(() => contexts.consumeFileToolInvocation(call.capability, parent, call.toolName), { code: 'REPO_FILE_INVOCATION_INVALID' });
  assert.equal(contexts.assertFileToolInvocationCurrent(call.capability, parent, call.toolName), metadata);
});

test('currentness requires consumption and ending a call does not retire its parent or sibling', t => {
  const parent = scope(t);
  const first = begin(t, parent);
  const second = begin(t, parent, 'repo.patch_file');
  assert.throws(() => contexts.assertFileToolInvocationCurrent(first.capability, parent, first.toolName), { code: 'REPO_FILE_INVOCATION_INVALID' });
  contexts.consumeFileToolInvocation(first.capability, parent, first.toolName);
  const secondMetadata = contexts.consumeFileToolInvocation(second.capability, parent, second.toolName);
  contexts.endFileToolInvocation(first.capability);
  contexts.endFileToolInvocation(first.capability);
  assert.throws(() => contexts.assertFileToolInvocationCurrent(first.capability, parent, first.toolName), { code: 'REPO_FILE_INVOCATION_INVALID' });
  assert.equal(contexts.assertFileToolInvocationCurrent(second.capability, parent, second.toolName), secondMetadata);
  assert.equal(contexts.requireFileToolContext(parent), parent.binding);
});

test('scope retirement revokes in-flight and unconsumed calls synchronously', async t => {
  const parent = scope(t);
  const first = begin(t, parent);
  const pending = begin(t, parent);
  contexts.consumeFileToolInvocation(first.capability, parent, first.toolName);
  let cleanupFinished = false;
  contexts.onFileToolContextRetired(parent, 'test-delay', () => { cleanupFinished = true; });
  const closing = contexts.retireFileToolContext(parent, 'revoked');
  assert.equal(cleanupFinished, false);
  assert.throws(() => contexts.assertFileToolInvocationCurrent(first.capability, parent, first.toolName), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  assert.throws(() => contexts.consumeFileToolInvocation(pending.capability, parent, pending.toolName), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  assert.throws(() => contexts.beginFileToolInvocation(parent, { invocationId: `invocation-${randomUUID()}`, toolName: 'repo.read_file' }), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  await closing;
  assert.equal(cleanupFinished, true);
});

test('anonymous transport calls have no asserted session association', async t => {
  for (const scopeKind of ['standalone-mcp', 'paired-desktop']) {
    const parent = contexts.createFileToolContext({ scopeKind });
    t.after(() => contexts.retireFileToolContext(parent));
    const call = begin(t, parent, 'repo.write_file');
    const metadata = contexts.consumeFileToolInvocation(call.capability, parent, call.toolName);
    assert.equal(metadata.sessionAssociation, null);
    assert.equal(parent.binding.canonicalLaunchId, null);
    assert.equal(parent.binding.runId, null);
  }
});

test('only the registered file tools and registry-shaped invocation identifiers are accepted', t => {
  const parent = scope(t);
  for (const input of [
    {}, { invocationId: 'client-request', toolName: 'repo.read_file' },
    // host.list_dir is not byte-mediated; the three host file tools are (2026-09-11).
    { invocationId: `invocation-${randomUUID()}`, toolName: 'host.list_dir' },
    { invocationId: `invocation-${randomUUID()}`, toolName: 'repo.read_file', sessionId: 'forged' }
  ]) assert.throws(() => contexts.beginFileToolInvocation(parent, input), { code: 'REPO_FILE_INVOCATION_INVALID' });
  for (const toolName of ['host.read_file', 'host.write_file', 'host.patch_file']) {
    const invocation = contexts.beginFileToolInvocation(parent, { invocationId: `invocation-${randomUUID()}`, toolName });
    assert.equal(contexts.consumeFileToolInvocation(invocation, parent, toolName).toolName, toolName);
    contexts.endFileToolInvocation(invocation);
  }
});

test('FRA authority requires an exact private accepted-record association, not a generic or copied scope', async t => {
  const workspaceContext = Object.freeze({ clientHost: 'client', serverHost: 'server', generation: 1,
    sessionContextDigest: 'a'.repeat(64) });
  let current = true;
  const parent = contexts.createFraFileToolContext({ workspaceContext, assertCurrent: () => {
    if (!current) throw Object.assign(new Error('fixture accepted record retired'), { code: 'WORKSPACE_FRA_CONTEXT_REQUIRED' });
  } });
  const generic = contexts.createFileToolContext({ scopeKind: 'paired-desktop' });
  t.after(() => Promise.all([contexts.retireFileToolContext(parent), contexts.retireFileToolContext(generic)]));
  assert.equal(contexts.requireFraFileToolContext(parent, workspaceContext), parent.binding);
  for (const [candidate, association] of [[generic, undefined], [generic, workspaceContext],
    [parent, { ...workspaceContext }], [parent, undefined]]) {
    assert.throws(() => contexts.requireFraFileToolContext(candidate, association), { code: 'WORKSPACE_FRA_CONTEXT_REQUIRED' });
  }
  assert.throws(() => contexts.requireFraFileToolContext(JSON.parse(JSON.stringify(parent)), workspaceContext),
    { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  const call = begin(t, parent, 'workspace.read');
  const metadata = contexts.consumeFileToolInvocation(call.capability, parent, call.toolName);
  assert.equal(metadata.sessionAssociation, null);
  current = false;
  assert.throws(() => contexts.requireFraFileToolContext(parent, workspaceContext), { code: 'WORKSPACE_FRA_CONTEXT_REQUIRED' });
  assert.throws(() => contexts.assertFileToolInvocationCurrent(call.capability, parent, call.toolName),
    { code: 'WORKSPACE_FRA_CONTEXT_REQUIRED' });
});

test('FRA currentness guards must be synchronous, including rejected asynchronous guards', async () => {
  const workspaceContext = Object.freeze({ clientHost: 'client', serverHost: 'server', generation: 1,
    sessionContextDigest: 'b'.repeat(64) });
  for (const assertCurrent of [() => Promise.resolve(), () => Promise.reject(new Error('fixture async guard refusal'))]) {
    assert.throws(() => contexts.createFraFileToolContext({ workspaceContext, assertCurrent }),
      { code: 'WORKSPACE_FRA_CONTEXT_REQUIRED' });
  }
  await new Promise(resolve => setImmediate(resolve));
});

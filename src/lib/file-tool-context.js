'use strict';

// Internal transport capability, never MCP arguments or environment identity.
// A runtime scope is NOT a canonical controller LaunchRecord. Unknown task,
// lane, and launch associations remain null instead of being inferred.
const { randomUUID } = require('node:crypto');
const { AGENT_ID_RE } = require('./agent-session-credential');
const capabilities = require('./file-tool-capabilities');
const { requireFileToolContext, retireFileToolContext, onFileToolContextRetired,
  consumeFileToolInvocation, assertFileToolInvocationCurrent, endFileToolInvocation } = capabilities;
const sessionAssociations = new WeakMap();
const fraAssociations = new WeakMap();
// @source(tool-registry.executeTool: its server-generated randomUUID identity).
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_TOOLS = new Set(['repo.read_file', 'repo.patch_file', 'repo.write_file', 'workspace.read',
  'host.read_file', 'host.write_file', 'host.patch_file']);

function refused() {
  return Object.assign(new Error('Repository coordination requires a current transport-bound file scope; caller-supplied actor fields cannot establish one.'), {
    code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED'
  });
}

function createFileToolContext({ scopeKind, agentId = null, sessionId = null } = {}) {
  if (!['owner-host-session', 'standalone-mcp', 'paired-desktop'].includes(scopeKind)
      || (agentId !== null && (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)))
      || (scopeKind !== 'owner-host-session' && agentId !== null)
      || (scopeKind !== 'owner-host-session' && sessionId !== null)
      // @source(owner-host.validSessionId: exact accepted-session wire bound).
      || (scopeKind === 'owner-host-session' && (typeof sessionId !== 'string' || !sessionId
        || sessionId.length > 128 || /[\0\r\n]/.test(sessionId)))) throw refused();
  const runtimeScopeId = `file-scope-${randomUUID()}`;
  const context = Object.freeze({
    binding: Object.freeze({
      principal: scopeKind === 'owner-host-session' && agentId !== null
        ? `agent:${agentId}` : `transport:${runtimeScopeId}`,
      runtimeScopeId, scopeKind,
      canonicalLaunchId: null, laneId: null, runId: null, rosterRef: null
    })
  });
  capabilities.registerFileToolContext(context);
  // This association is not part of the immutable v2 byte-store binding. The
  // owner host accepted the session ID; it did not necessarily generate it,
  // allocate a canonical run, or establish a controller LaunchRecord.
  sessionAssociations.set(context, scopeKind === 'owner-host-session'
    ? Object.freeze({ kind: 'owner-host-accepted-session', sessionId }) : null);
  return context;
}

function fraRefused() {
  return Object.assign(new Error('Workspace access requires the current private capability of its accepted FRA connection.'), {
    code: 'WORKSPACE_FRA_CONTEXT_REQUIRED'
  });
}

function assertFraCurrent(assertCurrent) {
  const result = assertCurrent();
  if (result && typeof result.then === 'function') {
    // Refuse async guards without leaving their rejection unobserved. The
    // transport's final release check cannot yield to a retirement microtask.
    Promise.resolve(result).catch(() => {});
    throw fraRefused();
  }
}

// Called only by the authenticated listener after binding acceptance. The
// serializable peer-visible digest is an association, never a capability.
// Reuse paired-desktop's v2 store binding; no durable identity/schema changes.
function createFraFileToolContext({ workspaceContext, assertCurrent } = {}) {
  if (!workspaceContext || !Object.isFrozen(workspaceContext)
      || Object.keys(workspaceContext).sort().join(',') !== 'clientHost,generation,serverHost,sessionContextDigest'
      || !/^[a-f0-9]{64}$/.test(workspaceContext.sessionContextDigest || '')
      || !Number.isSafeInteger(workspaceContext.generation) || workspaceContext.generation < 1
      || typeof assertCurrent !== 'function') throw fraRefused();
  assertFraCurrent(assertCurrent);
  const context = createFileToolContext({ scopeKind: 'paired-desktop' });
  fraAssociations.set(context, { workspaceContext, assertCurrent });
  capabilities.guardFileToolContext(context, () => assertFraCurrent(assertCurrent));
  return context;
}

function requireFraFileToolContext(context, workspaceContext) {
  const binding = requireFileToolContext(context);
  const association = fraAssociations.get(context);
  if (!association || association.workspaceContext !== workspaceContext) throw fraRefused();
  return binding;
}

function invocationRefused() {
  return Object.assign(new Error('Repository file execution requires this dispatch\'s current private one-shot invocation; a returned call trace cannot authorize another call.'), {
    code: 'REPO_FILE_INVOCATION_INVALID'
  });
}

function beginFileToolInvocation(context, options = {}) {
  const binding = requireFileToolContext(context);
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || Reflect.ownKeys(options).length !== 2
      || !Object.hasOwn(options, 'invocationId') || !Object.hasOwn(options, 'toolName')
      || typeof options.invocationId !== 'string' || !INVOCATION_ID.test(options.invocationId)
      || !FILE_TOOLS.has(options.toolName)) throw invocationRefused();
  // The public metadata is deliberately separate from the private capability.
  // It describes this call only: no durable/recovered operation attribution.
  const metadata = Object.freeze({
    schemaVersion: 1, invocationId: options.invocationId, toolName: options.toolName,
    runtimeScopeId: binding.runtimeScopeId, sessionAssociation: sessionAssociations.get(context)
  });
  return capabilities.registerFileToolInvocation(context, metadata);
}

module.exports = { createFileToolContext, requireFileToolContext, retireFileToolContext, onFileToolContextRetired,
  createFraFileToolContext, requireFraFileToolContext,
  beginFileToolInvocation, consumeFileToolInvocation, assertFileToolInvocationCurrent, endFileToolInvocation };

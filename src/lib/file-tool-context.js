'use strict';

// A private, transport-bound scope for mediated host file calls. The scope
// persists across calls; each dispatch receives its own one-shot invocation.
const { randomUUID } = require('node:crypto');
const capabilities = require('./file-tool-capabilities');
const { requireFileToolContext, retireFileToolContext, onFileToolContextRetired,
  consumeFileToolInvocation, assertFileToolInvocationCurrent, endFileToolInvocation } = capabilities;
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_TOOLS = new Set(['host.read_file', 'host.write_file', 'host.patch_file']);

function refused() {
  return Object.assign(new Error('Host file access requires a current transport-bound file scope.'), {
    code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED'
  });
}

function createFileToolContext({ scopeKind } = {}) {
  if (scopeKind !== 'standalone-mcp') throw refused();
  const runtimeScopeId = `file-scope-${randomUUID()}`;
  const context = Object.freeze({
    binding: Object.freeze({
      principal: `transport:${runtimeScopeId}`, runtimeScopeId, scopeKind,
      canonicalLaunchId: null, laneId: null, runId: null, rosterRef: null
    })
  });
  capabilities.registerFileToolContext(context);
  return context;
}

function invocationRefused() {
  return Object.assign(new Error('Host file execution requires this dispatch\'s current one-shot invocation.'), {
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
  const metadata = Object.freeze({
    schemaVersion: 1, invocationId: options.invocationId, toolName: options.toolName,
    runtimeScopeId: binding.runtimeScopeId
  });
  return capabilities.registerFileToolInvocation(context, metadata);
}

module.exports = { createFileToolContext, requireFileToolContext, retireFileToolContext, onFileToolContextRetired,
  beginFileToolInvocation, consumeFileToolInvocation, assertFileToolInvocationCurrent, endFileToolInvocation };

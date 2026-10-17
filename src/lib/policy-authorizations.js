'use strict';

// Policy authoritative dispatch adapter. It is deliberately not an MCP tool.
// A controller prepares one durable capability-bound authorization, then registry
// dispatch consumes it exactly once. Raw policy facts are never accepted at
// dispatch time.

const { getStateStore, hashInput } = require('./state-store');
const capabilityProfiles = require('./providers/capability-manifests');
const scopedApprovals = require('./fleet-approval-dispatch');

function error(code, message, details = {}) {
  const value = new Error(message);
  value.name = 'PolicyAuthorizationError';
  value.code = code;
  value.details = details;
  return value;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, keys, label) {
  if (!plainObject(value)) throw error('POLICY_AUTHORIZATION_INVALID', `${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw error('POLICY_AUTHORIZATION_INVALID', `${label} has unsupported or missing fields.`);
  }
  return value;
}

function stateFor(dependencies = {}) { return dependencies.state || getStateStore(); }

function actionSpec(toolName) {
  // Deliberately lazy: tool-registry loads this unregistered adapter before it
  // builds its protected policy catalog. The catalog getter itself is non-writable
  // and returns startup-frozen, code-owned action semantics.
  const { p13PolicyActionCatalog } = require('./tool-registry');
  return p13PolicyActionCatalog().find(item => item.name === toolName) || null;
}

function resolvedTarget(toolName, argumentsValue, boundRequest) {
  const spec = actionSpec(toolName);
  if (!spec || spec.policyKind === 'unmapped' || typeof spec.targetKind !== 'string') {
    throw error('POLICY_TARGET_AUTHORITY_UNAVAILABLE', 'Policy has no safe internal target resolver for this action.', { toolName });
  }
  if (!plainObject(boundRequest) || boundRequest.tool !== toolName) {
    throw error('POLICY_TARGET_AUTHORITY_UNAVAILABLE', 'Policy requires a normalized capability request before resolving the target.', { toolName });
  }
  // The target digest intentionally derives from the exact canonical tool
  // arguments and capability-normalized selectors. Caller-supplied target hashes are
  // never accepted or persisted as policy authority.
  return Object.freeze({
    kind: spec.targetKind,
    identifierHash: hashInput({
      domain: 'coordinator.policy-dispatch-target.v1', toolName,
      arguments: argumentsValue, capabilitySelectors: boundRequest
    }),
    pinned: true
  });
}

function prepare(input, dependencies = {}) {
  exact(input, [
    'authorizationId', 'profileId', 'version', 'requestId', 'request', 'arguments',
    'risk', 'delegationDepth', 'userKind'
  ], 'Policy authorization');
  const state = stateFor(dependencies);
  const capability = capabilityProfiles.authorizeBoundRequest({
    requestId: input.requestId,
    requestKind: 'tool',
    profileId: input.profileId,
    version: input.version,
    request: input.request
  }, { ...dependencies, state, enabled: true });
  const target = resolvedTarget(input.request.tool, input.arguments, capability.boundRequest);
  const saved = state.createPolicyDispatchAuthorization({
    authorizationId: input.authorizationId,
    taskId: input.request.taskId,
    toolName: input.request.tool,
    argsHash: hashInput(input.arguments),
    targetKind: target.kind,
    targetHash: target.identifierHash,
    // broker provenance envelopes supplied to this unregistered preparation adapter are
    // untrusted observations, never an allow-grant. scoped approval must add a broker-owned
    // provenance reference before confirmation-required dispatch can enable.
    provenance: null,
    risk: input.risk,
    delegationDepth: input.delegationDepth,
    userKind: input.userKind,
    requestHash: capability.requestHash
  });
  if (!plainObject(saved) || typeof saved.replayed !== 'boolean') {
    throw error('POLICY_AUTHORIZATION_STATE_INVALID', 'Policy could not establish whether the authorization was newly created or replayed.');
  }
  return Object.freeze({
    authorizationId: input.authorizationId,
    requestHash: capability.requestHash,
    manifestHash: capability.manifestHash,
    replayed: saved.replayed
  });
}

function consume(input, dependencies = {}) {
  const keys = plainObject(input) && Object.hasOwn(input, 'approvalEvidence')
    ? ['authorizationId', 'toolName', 'arguments', 'approvalEvidence']
    : ['authorizationId', 'toolName', 'arguments'];
  exact(input, keys, 'Policy dispatch consumption');
  const { authorizationId, toolName, arguments: argumentsValue, approvalEvidence = null } = input;
  if (approvalEvidence !== null) exact(approvalEvidence, ['approvalId'], 'Policy approval evidence');
  return stateFor(dependencies).consumePolicyDispatchAuthorization({
    authorizationId,
    toolName,
    argsHash: hashInput(argumentsValue),
    approvalId: approvalEvidence === null ? null : approvalEvidence.approvalId,
    approvalInputHash: approvalEvidence === null ? null : hashInput({ action: toolName, arguments: argumentsValue })
  });
}

function consumeScoped(input, dependencies = {}) {
  // Scoped approval intentionally accepts only the opaque UI response token.  It never
  // accepts an approval ID, a claimed status, a caller hash, raw provenance,
  // or a constructed preview as dispatch authority.
  exact(input, ['authorizationId', 'toolName', 'arguments', 'approvalToken'], 'scoped approval dispatch');
  const { authorizationId, toolName, arguments: argumentsValue, approvalToken } = input;
  return scopedApprovals.consumeForDispatch({ authorizationId, toolName, arguments: argumentsValue, approvalToken });
}

module.exports = Object.freeze({ consume, consumeScoped, prepare });

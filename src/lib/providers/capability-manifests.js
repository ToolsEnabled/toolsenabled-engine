'use strict';

// Durable P12 adapter.  It intentionally has no MCP registration yet: legacy
// direct MCP sessions are static allowlist compatibility paths and are not
// task-bound.  P13 will attach this guard to consequential dispatch.

const path = require('node:path');
const capability = require('../capability-manifests');
const elevationPolicy = require('../capability-elevation-policy');
const { getStateStore } = require('../state-store');
const { rootPath } = require('../runtime');
const coordinatorAudit = require('../coordinator-audit-events');

function manifestError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'CapabilityManifestProviderError';
  error.code = code;
  error.details = details;
  return error;
}

function durableState(dependencies = {}) { return dependencies.state || getStateStore(); }

function durableCapabilityState(dependencies = {}) {
  const state = durableState(dependencies);
  elevationPolicy.prepareState(state, dependencies);
  return state;
}

function configuredCatalog(dependencies = {}) {
  if (dependencies.catalog) return dependencies.catalog;
  // Lazy loading avoids a registry/provider initialization cycle.  The profile
  // service is not itself registered as a tool in P12.
  const { TOOL_REGISTRY } = require('../tool-registry');
  return {
    tools: TOOL_REGISTRY.map(tool => ({
      name: tool.name,
      effect: tool.effect,
      approvalEligible: tool.approvalEligible,
      inputSchema: tool.baseInputSchema
    })),
    roots: [{ id: 'toolsenabled', path: rootPath() }],
    domains: [],
    httpMethods: [],
    commandIds: [],
    secretHandles: [],
    externalActions: []
  };
}

function configuredProfiles(catalog, dependencies = {}) {
  if (dependencies.configuration) return dependencies.configuration;
  const file = dependencies.configurationFile || path.join(rootPath('config'), 'capability-base-profiles.json');
  return capability.loadConfiguration(file, capability.normalizeCatalog(catalog));
}

function auditProfile({ profileId, manifestHash, outcome, requestHash, required = false }, dependencies = {}) {
  const hashes = { capabilityProfile: manifestHash };
  if (requestHash) hashes.request = requestHash;
  const event = coordinatorAudit.createEvent({
    kind: 'capability.profile',
    subjectType: 'capability-profile',
    subjectReference: profileId,
    outcome,
    summary: { operation: 'profile', code: requestHash ? 'profile-bound-request' : 'capability-profile', count: 1 },
    hashes
  });
  const write = dependencies.auditWrite || coordinatorAudit.write;
  const status = write(event, {
    required,
    ...(dependencies.auditDependencies ? { auditDependencies: dependencies.auditDependencies } : {})
  });
  if (!status || status.durable !== true) {
    throw manifestError('CAPABILITY_MANIFEST_AUDIT_UNAVAILABLE', 'The capability profile audit event could not be recorded.');
  }
  return status;
}

function featureEnabled(dependencies = {}) {
  if (dependencies.enabled !== undefined) return dependencies.enabled === true;
  return process.env.TOOLSENABLED_CAPABILITY_MANIFESTS_ENABLED === 'true';
}

function compile(input, dependencies = {}) {
  const state = durableCapabilityState(dependencies);
  const catalog = configuredCatalog(dependencies);
  const normalizedCatalog = capability.normalizeCatalog(catalog);
  const configuration = configuredProfiles(catalog, dependencies);
  const clock = dependencies.now || (() => Date.now());
  const nowMs = clock();
  const boundedInput = elevationPolicy.boundedCompileInput(input, nowMs, dependencies);
  const compiled = capability.compileManifest(boundedInput, {
    catalog,
    configuration,
    now: () => nowMs
  });
  const saved = state.createCapabilityProfile({ manifest: compiled.manifest });
  auditProfile({ profileId: compiled.manifest.profileId, manifestHash: compiled.manifestHash, outcome: 'compiled' }, dependencies);
  return {
    replayed: saved.replayed,
    manifestHash: compiled.manifestHash,
    catalogHash: normalizedCatalog.hash,
    baseProfileHash: configuration.hash,
    profile: capability.inspect(saved.profile.manifest, saved.profile.status)
  };
}

function profile(input, dependencies = {}) {
  const stored = durableCapabilityState(dependencies).getCapabilityProfile(input);
  return stored ? capability.inspect(stored.manifest, stored.status) : null;
}

function requestExpansion(input, dependencies = {}) {
  if (!input || typeof input !== 'object') throw manifestError('CAPABILITY_MANIFEST_REQUEST_INVALID', 'A capability expansion request is required.');
  const stored = durableCapabilityState(dependencies).getCapabilityProfile({ profileId: input.profileId, version: input.version });
  if (!stored) throw manifestError('CAPABILITY_MANIFEST_MISSING', 'The capability profile was not found.');
  const expansion = capability.expansionRequest(stored.manifest, {
    reason: input.reason,
    requested: input.requested,
    evidenceReference: input.evidenceReference,
    expectedAction: input.expectedAction
  });
  const requestId = typeof input.requestId === 'string' ? input.requestId : null;
  if (!requestId) throw manifestError('CAPABILITY_MANIFEST_REQUEST_INVALID', 'requestId is required for a durable expansion request.');
  const saved = durableState(dependencies).recordCapabilityProfileRequest({
    requestId,
    taskId: stored.manifest.taskId,
    requestKind: 'expansion',
    profileId: stored.manifest.profileId,
    profileVersion: stored.manifest.version,
    profileHash: stored.manifestHash,
    requestHash: expansion.requestHash,
    request: {
      profileHash: expansion.profileHash,
      reasonHash: expansion.reasonHash,
      requestedHash: expansion.requestedHash,
      evidenceReference: expansion.evidenceReference,
      expectedActionHash: expansion.expectedActionHash
    },
    status: 'requested'
  });
  auditProfile({ profileId: stored.manifest.profileId, manifestHash: stored.manifestHash, outcome: 'requested', requestHash: expansion.requestHash }, dependencies);
  return { replayed: saved.replayed, requestHash: expansion.requestHash, grantsAuthority: false };
}

function authorizeBoundRequest(input, dependencies = {}) {
  if (!featureEnabled(dependencies)) throw manifestError('CAPABILITY_MANIFESTS_DISABLED', 'Profile-bound authorization is disabled until an explicitly enabled controller uses it.');
  if (!input || typeof input !== 'object') throw manifestError('CAPABILITY_MANIFEST_REQUEST_INVALID', 'A profile-bound request is required.');
  const stored = durableCapabilityState(dependencies).getCapabilityProfile({ profileId: input.profileId, version: input.version });
  if (!stored) throw manifestError('CAPABILITY_MANIFEST_MISSING', 'The capability profile was not found.');
  const request = capability.authorize(stored.manifest, stored.status, input.request, { now: dependencies.now ? dependencies.now() : Date.now() });
  const requestId = typeof input.requestId === 'string' ? input.requestId : null;
  const kind = input.requestKind === 'delegation' ? 'delegation' : input.requestKind === 'tool' ? 'tool' : null;
  if (!requestId || !kind) throw manifestError('CAPABILITY_MANIFEST_REQUEST_INVALID', 'requestId and requestKind are required for a profile-bound request.');
  const state = durableState(dependencies);
  const saved = state.authorizeCapabilityProfileRequest({
    taskId: request.manifest.taskId,
    bindingKind: kind,
    requestId,
    profileId: request.manifest.profileId,
    profileVersion: request.manifest.version,
    profileHash: request.profileHash,
    requestHash: request.requestHash,
    request
  });
  const tool = request.manifest.grants.tools.find(item => item.name === request.request.tool);
  auditProfile({
    profileId: request.manifest.profileId,
    manifestHash: request.profileHash,
    outcome: 'authorized',
    requestHash: request.requestHash,
    required: tool && tool.effect === 'external-write'
  }, dependencies);
  // This adapter remains unregistered. The normalized request contains only
  // P12-validated selectors (paths are already hashes) and lets P13 bind its
  // derived target to the exact authorized scope rather than caller prose.
  return Object.freeze({
    replayed: saved.replayed,
    manifestHash: request.profileHash,
    requestHash: request.requestHash,
    boundRequest: request.request,
    grantsAuthority: false
  });
}

function revoke(input, dependencies = {}) {
  const state = durableCapabilityState(dependencies);
  const stored = state.getCapabilityProfile({ profileId: input && input.profileId, version: input && input.version });
  if (!stored) throw manifestError('CAPABILITY_MANIFEST_MISSING', 'The capability profile was not found.');
  const saved = state.revokeCapabilityProfile({
    profileId: stored.manifest.profileId,
    version: stored.manifest.version,
    profileHash: stored.manifestHash,
    reasonCode: input && input.reasonCode
  });
  auditProfile({ profileId: stored.manifest.profileId, manifestHash: stored.manifestHash, outcome: 'revoked' }, dependencies);
  return { replayed: saved.replayed, revokedAtMs: saved.revokedAtMs };
}

module.exports = Object.freeze({
  authorizeBoundRequest, compile, featureEnabled, profile, requestExpansion, revoke
});

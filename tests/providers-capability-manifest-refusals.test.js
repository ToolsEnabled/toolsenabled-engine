'use strict';

const assert = require('node:assert/strict');
const capability = require('../src/lib/capability-manifests');
const stateStorePath = require.resolve('../src/lib/state-store');
require.cache[stateStorePath] = {
  id: stateStorePath,
  filename: stateStorePath,
  loaded: true,
  exports: { getStateStore: () => { throw new Error('unexpected default state store'); } }
};
const provider = require('../src/lib/providers/capability-manifests');

const nowMs = Date.UTC(2026, 7, 27, 12, 0, 0);

function assertRefusal(code, message, operation, counters) {
  const before = { ...counters };
  assert.throws(operation, error => {
    assert.equal(error.name, 'CapabilityManifestProviderError');
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.deepEqual(error.details, {});
    return true;
  });
  assert.deepEqual(counters, before, 'a refused call must not write, audit, or spawn');
}

try {
  const task = { id: 'task-refusal-test-00000001' };
  const catalog = {
    tools: [{
      name: 'fixture.read',
      effect: 'local-read',
      approvalEligible: false,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    }],
    roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: []
  };
  const configuration = capability.normalizeConfiguration({
    schemaVersion: 1,
    profiles: [{
      id: 'fixture-readonly',
      tools: ['fixture.read'], roots: [], domains: [], httpMethods: [], commandIds: [],
      secretHandles: [], externalActions: [], approvalRequiredActions: [], deniedTools: [],
      completionCriteria: ['read-complete'], maxTtlMs: 300_000
    }]
  }, capability.normalizeCatalog(catalog));
  const counters = { writes: 0, audits: 0, spawns: 0 };
  const profiles = new Map();
  const trackedState = {
    createCapabilityProfile({ manifest }) {
      const profile = { manifest, status: { revoked: false } };
      profiles.set(`${manifest.profileId}:${manifest.version}`, {
        ...profile,
        manifestHash: capability.manifestHash(manifest)
      });
      return { replayed: false, profile };
    },
    getCapabilityProfile({ profileId, version }) {
      return profiles.get(`${profileId}:${version}`) || null;
    },
    recordCapabilityProfileRequest() { counters.writes += 1; throw new Error('unexpected write'); },
    authorizeCapabilityProfileRequest() { counters.writes += 1; throw new Error('unexpected write'); },
    revokeCapabilityProfile() { counters.writes += 1; throw new Error('unexpected write'); },
    revokeActiveCapabilityProfiles() { counters.writes += 1; throw new Error('unexpected write'); }
  };
  const dependencies = {
    state: trackedState,
    catalog,
    configuration,
    enabled: true,
    now: () => nowMs,
    loadSettings: () => ({
      values: {
        'capability.elevation_duration': 5,
        'capability.elevation_survives_restart': true
      },
      rejected: []
    }),
    auditWrite: () => {
      counters.audits += 1;
      return { durable: true };
    },
    spawn: () => { counters.spawns += 1; }
  };

  provider.compile({
    profileId: 'provider.refusals',
    version: 1,
    taskId: task.id,
    baseProfileId: 'fixture-readonly',
    requested: {
      tools: ['fixture.read'], roots: [], domains: [], httpMethods: [], commandIds: [],
      secretHandles: [], externalActions: [], approvalRequiredActions: [],
      completionCriteria: ['read-complete'], expiresAtMs: nowMs + 240_000
    }
  }, dependencies);
  counters.audits = 0;

  const missing = { profileId: 'does.not.exist', version: 1 };
  const missingMessage = 'The capability profile was not found.';
  assertRefusal('CAPABILITY_MANIFEST_MISSING', missingMessage,
    () => provider.requestExpansion({ requestId: 'missing-expansion', ...missing }, dependencies), counters);
  assertRefusal('CAPABILITY_MANIFEST_MISSING', missingMessage,
    () => provider.authorizeBoundRequest({ requestId: 'missing-tool', requestKind: 'tool', ...missing }, dependencies), counters);
  assertRefusal('CAPABILITY_MANIFEST_MISSING', missingMessage,
    () => provider.revoke(missing, dependencies), counters);

  assertRefusal('CAPABILITY_MANIFEST_REQUEST_INVALID', 'A capability expansion request is required.',
    () => provider.requestExpansion(null, dependencies), counters);
  assertRefusal('CAPABILITY_MANIFEST_REQUEST_INVALID', 'requestId is required for a durable expansion request.',
    () => provider.requestExpansion({
      profileId: 'provider.refusals', version: 1, reason: 'test',
      requested: { tools: ['fixture.read'] }, evidenceReference: 'test:evidence',
      expectedAction: 'Read the fixture.'
    }, dependencies), counters);
  assertRefusal('CAPABILITY_MANIFEST_REQUEST_INVALID', 'A profile-bound request is required.',
    () => provider.authorizeBoundRequest(null, dependencies), counters);
  assertRefusal('CAPABILITY_MANIFEST_REQUEST_INVALID',
    'requestId and requestKind are required for a profile-bound request.',
    () => provider.authorizeBoundRequest({
      profileId: 'provider.refusals', version: 1,
      request: { taskId: task.id, tool: 'fixture.read' }
    }, dependencies), counters);

  console.log('capability-manifests provider refusals passed');
} finally {
  delete require.cache[stateStorePath];
}

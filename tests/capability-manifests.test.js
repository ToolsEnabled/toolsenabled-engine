'use strict';

const assert = require('node:assert/strict');
const capabilityManifests = require('../src/lib/capability-manifests');

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const TASK_ID = 'task-capability-0001';
const TOOL = 'web.fetch';

const catalog = {
  tools: [{
    name: TOOL,
    effect: 'external-read',
    approvalEligible: false,
    inputSchema: { type: 'object', additionalProperties: false }
  }],
  domains: ['api.example.test'],
  httpMethods: ['GET']
};

const configuration = {
  schemaVersion: capabilityManifests.SCHEMA_VERSION,
  profiles: [{
    id: 'read-web',
    tools: [TOOL],
    domains: ['api.example.test'],
    httpMethods: ['GET'],
    maxTtlMs: 60_000
  }]
};

const { manifest, manifestHash } = capabilityManifests.compileManifest({
  profileId: 'task-profile',
  version: 1,
  taskId: TASK_ID,
  baseProfileId: 'read-web'
}, { catalog, configuration, now: () => NOW });

assert.match(manifestHash, /^[a-f0-9]{64}$/);
assert.deepEqual(manifest.grants.domains, ['api.example.test']);
assert.deepEqual(manifest.grants.httpMethods, ['GET']);
assert.equal(manifest.expiresAtMs, NOW + 60_000);

const authorization = capabilityManifests.authorize(manifest, { revoked: false }, {
  taskId: TASK_ID,
  tool: TOOL,
  domain: 'API.EXAMPLE.TEST',
  httpMethod: 'GET'
}, { now: NOW });

assert.equal(authorization.request.domain, 'api.example.test');
assert.equal(authorization.profileHash, manifestHash);
assert.match(authorization.requestHash, /^[a-f0-9]{64}$/);

for (const selector of ['domain', 'httpMethod']) {
  const request = { taskId: TASK_ID, tool: TOOL, domain: 'api.example.test', httpMethod: 'GET' };
  delete request[selector];
  assert.throws(
    () => capabilityManifests.authorize(manifest, { revoked: false }, request, { now: NOW }),
    error => error instanceof capabilityManifests.CapabilityManifestError
      && error.code === 'CAPABILITY_MANIFEST_SELECTOR_REQUIRED'
      && error.details.field === selector,
    `authorize must require the constrained ${selector} selector`
  );
}

assert.throws(
  () => capabilityManifests.authorize(manifest, { revoked: false }, {
    taskId: TASK_ID,
    tool: TOOL,
    domain: 'other.example.test',
    httpMethod: 'GET'
  }, { now: NOW }),
  error => error instanceof capabilityManifests.CapabilityManifestError
    && error.code === 'CAPABILITY_MANIFEST_SCOPE_DENIED'
    && error.details.field === 'domain',
  'authorize must reject a selector outside the compiled grant'
);

console.log('capability-manifests behavior: PASS');

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const binding = require('../src/lib/fra-transport-binding');

const hex = label => crypto.createHash('sha256').update(label).digest('hex');
const refusal = (expected, operation) => {
  let returned = Symbol('not returned');
  assert.throws(() => { returned = operation(); }, error => {
    assert.equal(error && error.name, 'FraTransportBindingError');
    assert.equal(error && error.code, expected);
    return true;
  });
  assert.equal(typeof returned, 'symbol', `${expected} must not return a value`);
};

// Refusals in this module happen before any transport dispatch. Guard that
// property explicitly: none of these driven public entry points receives an
// executor, and the only injected effect below (the root filesystem) records
// that the invalid input was rejected before a filesystem call.
const noFsCalls = new Proxy({}, {
  get() { throw new Error('invalid root reached the filesystem'); }
});
refusal('FRA_ROOT_IDENTITY_INVALID', () =>
  binding.rootIdentityReport({ root: '', fsApi: noFsCalls }));

refusal('FRA_CANONICAL_VALUE_INVALID', () => binding.digest('test', Infinity));
refusal('FRA_CANONICAL_VALUE_TOO_LARGE', () =>
  binding.digest('test', 'x'.repeat(1024 * 1024 + 1)));
refusal('FRA_PROJECTOR_PROFILE_INVALID', () => binding.projectorSetDigest([]));
refusal('FRA_PROFILE_BINDING_INVALID', () => binding.capabilityProfileDigest({}));

const registry = {
  schemaVersion: 1,
  machines: {
    a: { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    b: { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
refusal('FRA_BINDING_HOST_INVALID', () => binding.createServerBinding({
  serverHost: '203.0.113.2', clientHost: '203.0.113.2',
  serviceRegistryOptions: { registry }
}));

const allowedTools = ['system.status'];
const profile = {
  schemaVersion: 1,
  registryNameDigest: hex('registry'),
  allowedToolNamesDigest: hex(allowedTools.join('\n')),
  allowedToolCount: 1,
  allowedTools,
  excludedTools: [],
  desktopCapabilities: {},
  transportPolicy: binding.TRANSPORT_POLICY_DESCRIPTOR
};
const common = {
  session: { sessionId: Buffer.alloc(16, 1).toString('base64url'), generation: 1 },
  serverHost: '203.0.113.2', clientHost: '203.0.113.1',
  serviceRegistryOptions: { registry }, capabilityProfile: profile,
  runtimeDigest: hex('runtime'), policyDigest: hex('policy'),
  rootIdentity: { valid: true, rootIdentityDigest: hex('root') },
  rootAccessReport: {
    schemaVersion: 1, valid: true, policyDigest: hex('root-policy'),
    descriptorDigest: hex('acl'), secretValuesEmitted: false
  }
};
refusal('FRA_RUNTIME_BINDING_INVALID', () =>
  binding.createServerBinding({ ...common, runtimeDigest: 'not-a-digest' }));

const serverBinding = binding.createServerBinding(common);
refusal('FRA_BINDING_SHAPE_INVALID', () =>
  binding.workspaceContextFromBinding({ ...serverBinding, surprise: true }));
refusal('FRA_BINDING_DIGEST_INVALID', () => binding.validateServerBinding({
  ...serverBinding, runtimeDigest: 'bad'
}, {
  ...common,
  rootAccessPolicyDigest: common.rootAccessReport.policyDigest
}));
refusal('FRA_BINDING_ACCEPTANCE_INVALID', () =>
  binding.createBindingAcceptance({ ...serverBinding, contextDigest: 'bad' }));

refusal('FRA_BOUND_REQUEST_INVALID', () => binding.createBoundRequest({
  jsonrpc: '1.0', method: 'tools/list'
}, serverBinding.contextDigest));
refusal('FRA_BOUND_RESPONSE_INVALID', () => binding.validateBoundResponse({}, {
  requestEnvelope: {}, allowedTools
}));

const request = { jsonrpc: '2.0', id: 1, method: 'status/get', params: {} };
let deep = {};
for (let index = 0; index < 17; index += 1) deep = { child: deep };
refusal('FRA_RESULT_PROJECTION_TOO_DEEP', () => binding.projectMcpResponse(
  request, { jsonrpc: '2.0', id: 1, result: deep }, allowedTools
));
refusal('FRA_RESULT_PROJECTION_TOO_LARGE', () => binding.projectMcpResponse(
  request,
  { jsonrpc: '2.0', id: 1, result: 'x'.repeat(768 * 1024 + 1) },
  allowedTools
));

process.stdout.write('fra-transport-binding driven refusals: ok\n');

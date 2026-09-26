'use strict';

const crypto = require('node:crypto');
const { TRANSPORT_POLICY_DESCRIPTOR } = require('../../src/lib/fra-transport-binding');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

const TEST_POLICY_DIGEST = sha256('fra-test-policy');
const TEST_ROOT_IDENTITY_REPORT = Object.freeze({
  valid: true,
  rootIdentityDigest: sha256('fra-test-root-identity')
});
const TEST_ROOT_ACCESS_REPORT = Object.freeze({
  schemaVersion: 1,
  valid: true,
  policyDigest: sha256('fra-test-root-access-policy'),
  descriptorDigest: sha256('fra-test-root-acl'),
  secretValuesEmitted: false
});

function toolNamesDigest(names) {
  return crypto.createHash('sha256')
    .update([...names].sort().join('\n'), 'utf8').digest('hex');
}

function bindableCapabilityProfile(input = {}) {
  const allowedTools = [...(input.allowedTools || input.allowedToolNames || [])].sort();
  const hasScreen = allowedTools.some(name => name.startsWith('screen.'));
  const hasOcr = allowedTools.includes('ocr.read');
  return Object.freeze({
    ...input,
    schemaVersion: input.schemaVersion || 5,
    registryNameDigest: input.registryNameDigest || sha256('fra-test-registry'),
    allowedToolNamesDigest: toolNamesDigest(allowedTools),
    allowedToolCount: allowedTools.length,
    allowedTools: Object.freeze([...allowedTools]),
    allowedToolNames: Object.freeze([...allowedTools]),
    excludedTools: Object.freeze([...(input.excludedTools || [])].sort()),
    desktopCapabilities: Object.freeze({
      clipboard: false,
      ocr: hasOcr,
      screenCapture: hasScreen,
      ...(input.desktopCapabilities || {})
    }),
    transportPolicy: Object.freeze({
      ...TRANSPORT_POLICY_DESCRIPTOR,
      ...(input.transportPolicy || {})
    })
  });
}

function bridgeTrustOptions(runtimeDigest = 'd'.repeat(64)) {
  return Object.freeze({
    runtimeIntegrityReport: Object.freeze({
      valid: true,
      runtimeDigest,
      manifestSha256: 'e'.repeat(64)
    }),
    rootIdentityReport: TEST_ROOT_IDENTITY_REPORT,
    rootAccessReport: TEST_ROOT_ACCESS_REPORT,
    policyDigest: TEST_POLICY_DIGEST
  });
}

function bindingExpectations(runtimeDigest = 'd'.repeat(64)) {
  return Object.freeze({
    runtimeDigest,
    policyDigest: TEST_POLICY_DIGEST,
    rootAccessPolicyDigest: TEST_ROOT_ACCESS_REPORT.policyDigest,
    localRootIdentityDigest: sha256('fra-test-client-root'),
    localRootAclDigest: sha256('fra-test-client-acl')
  });
}

module.exports = Object.freeze({
  TEST_POLICY_DIGEST,
  TEST_ROOT_IDENTITY_REPORT,
  TEST_ROOT_ACCESS_REPORT,
  sha256,
  toolNamesDigest,
  bindableCapabilityProfile,
  bridgeTrustOptions,
  bindingExpectations
});

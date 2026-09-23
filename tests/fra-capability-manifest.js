'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SCHEMA_VERSION, TRANSPORT_POLICY_DESCRIPTOR, FraCapabilityManifestError, registryNameDigest, toolNameDigest,
  validateDeclaration, validateManifest, loadManifest, manifestPathForHost
} = require('../src/lib/fra-capability-manifest');

const registry = [
  { name: 'clipboard.read' }, { name: 'clipboard.write' },
  { name: 'host.exec' }, { name: 'host.list_dir' }, { name: 'host.patch_file' }, { name: 'host.read_file' }, { name: 'host.write_file' },
  { name: 'repo.list_dir' }, { name: 'repo.patch_file' }, { name: 'repo.read_file' }, { name: 'repo.write_file' },
  { name: 'code.status' }, { name: 'ocr.read' }, { name: 'screen.capture' }, { name: 'system.status' }
];

const requiredExcluded = [
  'clipboard.read', 'clipboard.write',
  'host.exec', 'host.list_dir', 'host.patch_file', 'host.read_file', 'host.write_file',
  'repo.list_dir', 'repo.patch_file', 'repo.read_file', 'repo.write_file'
];

function manifest(overrides = {}) {
  const allowed = ['code.status', 'ocr.read', 'screen.capture', 'system.status'];
  return {
    schemaVersion: SCHEMA_VERSION,
    registryNameDigest: registryNameDigest(registry),
    allowedToolNamesDigest: toolNameDigest(allowed),
    allowedToolCount: allowed.length,
    allowedTools: allowed,
    excludedTools: requiredExcluded,
    desktopCapabilities: {
      clipboard: false, ocr: true, screenCapture: true
    },
    transportPolicy: TRANSPORT_POLICY_DESCRIPTOR,
    ...overrides
  };
}

function code(fn, expected) {
  assert.throws(fn, error => error instanceof FraCapabilityManifestError && error.code === expected);
}

const valid = validateManifest(manifest(), { registry });
assert.deepEqual(valid.allowedToolNames, ['code.status', 'ocr.read', 'screen.capture', 'system.status']);
assert.equal(Object.isFrozen(valid.allowedToolNames), true);
assert.equal(validateDeclaration(manifest()).allowedToolCount, 4);
// The registry these host lookups resolve against is INJECTED, so this test
// pins behaviour instead of depending on whatever network the builder's own
// machine is on. Documentation addresses (RFC 5737) only -- nothing real.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\Users\\owner\\Desktop\\engine-checkout', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\elsewhere', role: 'disconnected-peer' }
  },
  services: {}
};

// B26. The manifest filename is keyed on the machine's stable registry
// IDENTITY, never on its address. An address is still an accepted way to NAME
// a machine -- every caller passes one -- but it is looked up, not
// interpolated, so the file does not have to be renamed when the network
// changes underneath it.
assert.match(manifestPathForHost('203.0.113.1', { registry: lab }), /fra-capability-manifest\.machine-b\.json$/);
assert.equal(manifestPathForHost('203.0.113.1', { registry: lab }), manifestPathForHost('machine-b', { registry: lab }),
  'naming a machine by address or by id must resolve to the same file');
assert.equal(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(manifestPathForHost('203.0.113.2', { registry: lab })), false,
  'no address may appear in a resolved manifest path');
code(() => manifestPathForHost('203.0.113.50', { registry: lab }), 'FRA_MANIFEST_HOST_INVALID');
code(() => manifestPathForHost('machine-z', { registry: lab }), 'FRA_MANIFEST_HOST_INVALID');
const ordinaryLanRegistry = {
  schemaVersion: 1,
  machines: { 'machine-a': { address: '10.0.0.5' }, 'machine-b': { address: '10.0.0.6' } },
  services: {}
};
assert.match(manifestPathForHost('10.0.0.5', { registry: ordinaryLanRegistry }), /fra-capability-manifest\.machine-a\.json$/);
code(() => manifestPathForHost('10.0.0.7', { registry: ordinaryLanRegistry }), 'FRA_MANIFEST_HOST_INVALID');

// THE MOVE THIS WHOLE CHANGE EXISTS FOR. Same machine, same declared root,
// completely different network -- the owner has said this will happen before
// testing. Nothing may be renamed and the same file must be found.
const movedNetworkRegistry = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.41', root: 'C:\\Users\\owner\\Desktop\\engine-checkout', role: 'development-host' },
    'machine-b': { address: '203.0.113.42', root: 'C:\\elsewhere', role: 'disconnected-peer' }
  },
  services: {}
};
assert.equal(manifestPathForHost('203.0.113.41', { registry: movedNetworkRegistry }),
  manifestPathForHost('203.0.113.2', { registry: lab }),
  'after a network move the SAME manifest file must resolve for the same machine');
code(() => manifestPathForHost('203.0.113.2', { registry: movedNetworkRegistry }), 'FRA_MANIFEST_HOST_INVALID');

// A registry machine id becomes a path component, so it is validated before it
// is ever joined to one. Sanitizing would be the wrong answer here.
const traversalRegistry = {
  schemaVersion: 1, machines: { '../../evil': { address: '10.9.9.9' } }, services: {}
};
code(() => manifestPathForHost('../../evil', { registry: traversalRegistry }), 'FRA_MANIFEST_HOST_INVALID');
code(() => manifestPathForHost('10.9.9.9', { registry: traversalRegistry }), 'FRA_MANIFEST_HOST_INVALID');

code(() => validateManifest(manifest({ allowedTools: ['screen.capture', 'ocr.read', 'code.status', 'system.status'] }), { registry }), 'FRA_MANIFEST_SCHEMA_INVALID');
code(() => validateManifest(manifest({ allowedTools: ['clipboard.read', 'code.status', 'ocr.read', 'screen.capture'] }), { registry }), 'FRA_MANIFEST_SAFETY_INVALID');
code(() => validateManifest(manifest({ allowedTools: ['code.status', 'ocr.read', 'system.status'] }), { registry }), 'FRA_MANIFEST_SAFETY_INVALID');
code(() => validateManifest(manifest({ desktopCapabilities: {
  clipboard: true, ocr: true, screenCapture: true
} }), { registry }), 'FRA_MANIFEST_SCHEMA_INVALID');
for (const obsoleteRequestId of ['R1', 'R731', 'R999999999']) {
  code(() => validateManifest(manifest({ desktopCapabilities: {
    [['authorization', 'RequestId'].join('')]: obsoleteRequestId,
    clipboard: false, ocr: true, screenCapture: true
  } }), { registry }), 'FRA_MANIFEST_SCHEMA_INVALID');
}
code(() => validateManifest(manifest({ transportPolicy: {
  ...TRANSPORT_POLICY_DESCRIPTOR, pathIdentityDisclosure: true
} }), { registry }), 'FRA_MANIFEST_SCHEMA_INVALID');
code(() => validateManifest(manifest({ excludedTools: [] }), { registry }), 'FRA_MANIFEST_SAFETY_INVALID');
code(() => validateManifest(manifest({ excludedTools: [...requiredExcluded, 'missing.tool'] }), { registry }), 'FRA_MANIFEST_SCHEMA_INVALID');
code(() => validateManifest(manifest({ allowedToolCount: 5 }), { registry }), 'FRA_MANIFEST_CAPABILITY_MISMATCH');
code(() => validateManifest(manifest(), { registry: [...registry, { name: 'window.list' }] }), 'FRA_MANIFEST_DIGEST_MISMATCH');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-manifest-'));
const manifestPath = path.join(directory, 'manifest.json');
try {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest()), 'utf8');
  assert.deepEqual(loadManifest({ registry, manifestPath }).allowedToolNames, valid.allowedToolNames);
  code(() => loadManifest({ registry, manifestPath: path.join(directory, 'missing.json') }), 'FRA_MANIFEST_LOAD_FAILED');
  fs.writeFileSync(manifestPath, '{not json', 'utf8');
  code(() => loadManifest({ registry, manifestPath }), 'FRA_MANIFEST_LOAD_FAILED');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('FRA capability manifest tests passed.');

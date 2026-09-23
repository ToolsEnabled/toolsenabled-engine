'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
const {
  SCHEMA_VERSION,
  TRANSPORT_POLICY_DESCRIPTOR,
  REQUIRED_EXCLUDED_TOOLS,
  loadManifest,
  loadManifestDeclaration,
  manifestPathForHost,
  registryNameDigest,
  toolNameDigest
} = require('../src/lib/fra-capability-manifest');

// Endpoint identity is tested against an injected registry using RFC 5737
// documentation addresses. The capability declarations themselves are two
// independent temporary files; this test never reads a machine-local manifest
// and never reaches a live endpoint.
const endpointRegistry = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '192.0.2.10', root: 'C:\\fixture\\machine-a', role: 'development-host' },
    'machine-b': { address: '192.0.2.11', root: 'C:\\fixture\\machine-b', role: 'disconnected-peer' }
  },
  services: {}
};
assert.match(manifestPathForHost('192.0.2.10', { registry: endpointRegistry }), /fra-capability-manifest\.machine-a\.json$/);
assert.match(manifestPathForHost('192.0.2.11', { registry: endpointRegistry }), /fra-capability-manifest\.machine-b\.json$/);

const allowedTools = [
  'browser.playwright_call',
  'ocr.read',
  'screen.capture',
  'screen.read_capture',
  'system.status',
  'workspace.list',
  'workspace.read',
  'workstation.install_cursor'
].sort();
const declaration = {
  schemaVersion: SCHEMA_VERSION,
  registryNameDigest: registryNameDigest(TOOL_REGISTRY),
  allowedToolNamesDigest: toolNameDigest(allowedTools),
  allowedToolCount: allowedTools.length,
  allowedTools,
  excludedTools: [...REQUIRED_EXCLUDED_TOOLS].sort(),
  desktopCapabilities: { clipboard: false, ocr: true, screenCapture: true },
  transportPolicy: TRANSPORT_POLICY_DESCRIPTOR
};

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-endpoint-manifests-'));
const machineAPath = path.join(fixtureRoot, 'fra-capability-manifest.machine-a.json');
const machineBPath = path.join(fixtureRoot, 'fra-capability-manifest.machine-b.json');
let machineA;
let machineB;
let remoteDeclaration;
try {
  fs.writeFileSync(machineAPath, JSON.stringify({ ...declaration }), 'utf8');
  fs.writeFileSync(machineBPath, JSON.stringify({ ...declaration }), 'utf8');
  machineA = loadManifest({ registry: TOOL_REGISTRY, manifestPath: machineAPath });
  machineB = loadManifest({ registry: TOOL_REGISTRY, manifestPath: machineBPath });
  remoteDeclaration = loadManifestDeclaration({ manifestPath: machineAPath });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

assert.equal(machineB.allowedToolCount, allowedTools.length);
assert.equal(machineA.allowedToolCount, allowedTools.length);
assert.ok(!machineB.allowedToolNames.some(name => /^topology_games\./.test(name)));
assert.ok(!machineA.allowedToolNames.some(name => /^topology_games\./.test(name)));
assert.equal(machineB.allowedToolNamesDigest, machineA.allowedToolNamesDigest);
assert.deepEqual(machineB.allowedToolNames, machineA.allowedToolNames);
assert.ok(!machineB.allowedToolNames.includes('host.exec'));
assert.ok(!machineB.allowedToolNames.includes('duo.desktop_status'));
assert.ok(!machineB.allowedToolNames.includes('model.role_complete'));
assert.ok(!machineB.allowedToolNames.includes('deployment.execute'));
assert.ok(!machineB.allowedToolNames.includes('terraform.apply'));
assert.ok(!machineB.allowedToolNames.includes('system.credential_request'));
assert.ok(!machineB.allowedToolNames.some(name => /^clipboard\./.test(name)));
for (const name of ['host.list_dir', 'host.read_file', 'host.write_file', 'repo.list_dir', 'repo.read_file', 'repo.write_file']) {
  assert.ok(!machineB.allowedToolNames.includes(name), `${name} is local-client-only, never FRA`);
}
assert.ok(machineB.allowedToolNames.includes('screen.capture'));
assert.ok(machineB.allowedToolNames.includes('screen.read_capture'));
assert.ok(machineB.allowedToolNames.includes('ocr.read'));
assert.ok(machineB.allowedToolNames.includes('browser.playwright_call'));
assert.ok(machineB.allowedToolNames.includes('workstation.install_cursor'));
assert.ok(machineB.allowedToolNames.includes('workspace.list'));
assert.ok(machineB.allowedToolNames.includes('workspace.read'));
assert.equal(machineB.transportPolicy.pathIdentityDisclosure, false);
assert.deepEqual(Object.keys(machineB.desktopCapabilities).sort(), ['clipboard', 'ocr', 'screenCapture']);

assert.equal(remoteDeclaration.registryNameDigest, machineA.registryNameDigest);
assert.equal(remoteDeclaration.allowedToolNamesDigest, machineA.allowedToolNamesDigest);
assert.equal(remoteDeclaration.allowedToolCount, machineA.allowedToolCount);

console.log('FRA endpoint capability manifests converge on one exact safe tool set.');

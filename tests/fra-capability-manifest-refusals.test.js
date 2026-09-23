'use strict';

// Drive the public API to each refusal. These checks deliberately avoid source
// inspection: changing any expected refusal at its throw site must make this
// file fail.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawnSync = childProcess.spawnSync;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };

const manifestApi = require('../src/lib/fra-capability-manifest');

function validDeclaration(overrides = {}) {
  const allowedTools = ['audit.read'];
  return {
    allowedToolCount: allowedTools.length,
    allowedToolNamesDigest: manifestApi.toolNameDigest(allowedTools),
    allowedTools,
    desktopCapabilities: {
      clipboard: false,
      ocr: false,
      screenCapture: false
    },
    excludedTools: [...manifestApi.REQUIRED_EXCLUDED_TOOLS].sort(),
    registryNameDigest: '0'.repeat(64),
    schemaVersion: manifestApi.SCHEMA_VERSION,
    transportPolicy: { ...manifestApi.TRANSPORT_POLICY_DESCRIPTOR },
    ...overrides
  };
}

function assertRefusal(code, invoke) {
  assert.throws(invoke, error => {
    assert.equal(error && error.name, 'FraCapabilityManifestError');
    assert.equal(error && error.code, code);
    return true;
  });
}

try {
  let reads = 0;
  assertRefusal('FRA_MANIFEST_PATH_INVALID', () => manifestApi.loadManifestDeclaration({
    manifestPath: '',
    readFile: () => { reads += 1; return '{}'; }
  }));
  assert.equal(reads, 0, 'an invalid path must refuse before attempting a read');

  assertRefusal('FRA_MANIFEST_REGISTRY_INVALID', () => manifestApi.validateManifest(
    validDeclaration(),
    { registry: null }
  ));

  assertRefusal('FRA_MANIFEST_VERSION_INVALID', () => manifestApi.validateDeclaration(
    validDeclaration({ schemaVersion: manifestApi.SCHEMA_VERSION - 1 })
  ));

  assert.equal(writes, 0, 'refusal paths must not write files');
  assert.equal(spawns, 0, 'refusal paths must not spawn processes');
  console.log('fra capability manifest path, registry, and version refusals are driven');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  childProcess.spawnSync = originalSpawnSync;
}

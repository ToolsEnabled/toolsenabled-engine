'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const capabilityManifests = require('../src/lib/capability-manifests');

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const TASK_ID = 'task-refusal-0001';
const TOOL = 'local.read';
const rootPath = fs.realpathSync.native(require('node:os').tmpdir());

const catalog = {
  tools: [{
    name: TOOL,
    effect: 'local-read',
    approvalEligible: false,
    inputSchema: { type: 'object' }
  }],
  roots: [{ id: 'tmp-root', path: rootPath }]
};
const configuration = {
  schemaVersion: capabilityManifests.SCHEMA_VERSION,
  profiles: [{ id: 'local-read', tools: [TOOL], roots: ['tmp-root'], maxTtlMs: 60_000 }]
};
const { manifest } = capabilityManifests.compileManifest({
  profileId: 'refusal-profile',
  version: 1,
  taskId: TASK_ID,
  baseProfileId: 'local-read'
}, { catalog, configuration, now: () => NOW });

let writes = 0;
let spawns = 0;
const restorers = [];
function countCalls(object, names, increment) {
  for (const name of names) {
    const original = object[name];
    object[name] = function countedCall(...args) {
      increment();
      return original.apply(this, args);
    };
    restorers.push(() => { object[name] = original; });
  }
}

countCalls(fs, ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync'], () => { writes += 1; });
countCalls(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'], () => { spawns += 1; });

function refusal(label, code, operation) {
  writes = 0;
  spawns = 0;
  assert.throws(operation, error =>
    error instanceof capabilityManifests.CapabilityManifestError && error.code === code,
  `${label} must throw ${code}`);
  assert.equal(writes, 0, `${label} must not write before refusing`);
  assert.equal(spawns, 0, `${label} must not spawn before refusing`);
}

try {
  refusal('unreadable configuration', 'CAPABILITY_MANIFEST_CONFIGURATION_UNAVAILABLE', () =>
    capabilityManifests.loadConfiguration(
      path.join(rootPath, `absent-capability-configuration-${process.pid}.json`),
      capabilityManifests.normalizeCatalog({ tools: [] })
    ));

  refusal('invalid catalog input', 'CAPABILITY_MANIFEST_INVALID', () =>
    capabilityManifests.normalizeCatalog({ tools: 'not-an-array' }));

  const realpath = fs.realpathSync.native;
  fs.realpathSync.native = filename => {
    if (filename === rootPath) throw Object.assign(new Error('simulated unavailable root'), { code: 'ENOENT' });
    return realpath(filename);
  };
  try {
    refusal('unavailable manifest root', 'CAPABILITY_MANIFEST_ROOT_UNAVAILABLE', () =>
      capabilityManifests.validateManifest(manifest));
  } finally {
    fs.realpathSync.native = realpath;
  }

  refusal('missing status', 'CAPABILITY_MANIFEST_STATUS_UNAVAILABLE', () =>
    capabilityManifests.inspect({ ...manifest, grants: { ...manifest.grants, roots: [] } }, undefined));
} finally {
  while (restorers.length) restorers.pop()();
}

console.log('capability manifest driven refusals: PASS');

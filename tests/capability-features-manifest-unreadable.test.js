'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const childProcess = require('node:child_process');

const { CapabilityFeatureError, resolveFeatures } = require('../src/lib/capability-features');

let writes = 0;
let spawns = 0;
let existenceChecks = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawnSync = childProcess.spawnSync;

fs.writeFileSync = (...args) => {
  writes += 1;
  throw new Error(`unexpected write: ${String(args[0])}`);
};
childProcess.spawnSync = (...args) => {
  spawns += 1;
  throw new Error(`unexpected spawn: ${String(args[0])}`);
};

try {
  const manifestFile = '/fixture/permission-denied/capability-features.json';
  const readFailure = Object.assign(new Error('fixture must not leak into the public error'), {
    code: 'EACCES'
  });

  assert.throws(
    () => resolveFeatures({
      manifestFile,
      readFile(file, encoding) {
        assert.equal(file, manifestFile);
        assert.equal(encoding, 'utf8');
        throw readFailure;
      },
      exists() {
        existenceChecks += 1;
        return true;
      }
    }),
    error => {
      assert.ok(error instanceof CapabilityFeatureError);
      assert.equal(error.code, 'FEATURE_MANIFEST_UNREADABLE');
      assert.equal(error.message,
        `${manifestFile} could not be read: EACCES`);
      return true;
    },
    'resolveFeatures must propagate the manifest-read refusal'
  );

  assert.equal(existenceChecks, 0,
    'resolution must stop before probing feature files');
  assert.equal(writes, 0, 'an unreadable manifest must not write anything');
  assert.equal(spawns, 0, 'an unreadable manifest must not spawn anything');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  childProcess.spawnSync = originalSpawnSync;
}

process.stdout.write('capability feature unreadable-manifest refusal: ok\n');

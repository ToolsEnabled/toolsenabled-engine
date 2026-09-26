'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const boundary = require('../src/lib/workspace-boundary');

const originalNativeRealpath = fs.realpathSync.native;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawnSync = childProcess.spawnSync;
const originalSpawn = childProcess.spawn;
let writes = 0;
let spawns = 0;

fs.writeFileSync = (...args) => {
  writes += 1;
  return originalWriteFileSync(...args);
};
fs.appendFileSync = (...args) => {
  writes += 1;
  return originalAppendFileSync(...args);
};
childProcess.spawnSync = (...args) => {
  spawns += 1;
  return originalSpawnSync(...args);
};
childProcess.spawn = (...args) => {
  spawns += 1;
  return originalSpawn(...args);
};

function isRefusal(code, label, underlyingCode) {
  return error => error instanceof boundary.WorkspaceBoundaryRefusal
    && error.code === code
    && error.details.label === label
    && (underlyingCode === undefined || error.details.code === underlyingCode);
}

try {
  assert.throws(
    () => boundary.assertShapeAllowed('\\\\server\\share\\secret.txt', 'inputPath'),
    isRefusal('WORKSPACE_PATH_REFUSED', 'inputPath')
  );
  assert.equal(writes, 0, 'a refused path must not write');
  assert.equal(spawns, 0, 'a refused path must not spawn');

  fs.realpathSync.native = undefined;
  assert.throws(
    () => boundary.realResolve('/workspace/future-output.txt', 'outputPath'),
    isRefusal('WORKSPACE_PATH_UNRESOLVABLE', 'outputPath')
  );
  assert.equal(writes, 0, 'failure to resolve a path must not write');
  assert.equal(spawns, 0, 'failure to resolve a path must not spawn');

  fs.realpathSync.native = () => {
    const error = new Error('fixture denied realpath inspection');
    error.code = 'EACCES';
    throw error;
  };
  assert.throws(
    () => boundary.realResolve('/workspace/future-output.txt', 'candidatePath'),
    isRefusal('WORKSPACE_PATH_UNRESOLVABLE', 'candidatePath', 'EACCES')
  );
  assert.equal(writes, 0, 'an indeterminate realpath must not write');
  assert.equal(spawns, 0, 'an indeterminate realpath must not spawn');

  fs.realpathSync.native = () => {
    const error = new Error('fixture reports every ancestor missing');
    error.code = 'ENOENT';
    throw error;
  };
  assert.throws(
    () => boundary.realResolve('/missing-volume/output.txt', 'volumePath'),
    error => isRefusal('WORKSPACE_PATH_UNRESOLVABLE', 'volumePath')(error)
      && error.message.includes('not on any volume')
  );
  assert.equal(writes, 0, 'an unresolved volume must not write');
  assert.equal(spawns, 0, 'an unresolved volume must not spawn');

  console.log('workspace boundary path refusal tests passed');
} finally {
  fs.realpathSync.native = originalNativeRealpath;
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawnSync = originalSpawnSync;
  childProcess.spawn = originalSpawn;
}

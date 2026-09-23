'use strict';

const assert = require('node:assert/strict');
const access = require('../src/lib/fra-root-access');

function assertRefusal(run, expectedCode) {
  assert.throws(run, error => {
    assert.ok(error instanceof access.FraRootAccessError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

function main() {
  let invalidOptionsSpawnCount = 0;
  assertRefusal(() => access.verifyFraRootAccess({
    root: 'relative-root',
    platform: 'win32',
    scriptPath: 'C:\\fixed\\fra-root-access-probe.ps1',
    spawnSyncApi: () => {
      invalidOptionsSpawnCount += 1;
      return { status: 0, stdout: '{}' };
    }
  }), 'FRA_ROOT_ACCESS_OPTIONS_INVALID');
  assert.equal(invalidOptionsSpawnCount, 0,
    'invalid options must be refused before the probe can be spawned');

  let unavailableSpawnCount = 0;
  assertRefusal(() => access.verifyFraRootAccess({
    root: 'C:\\fixed\\ToolsEnabled',
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    scriptPath: 'C:\\fixed\\fra-root-access-probe.ps1',
    spawnSyncApi: () => {
      unavailableSpawnCount += 1;
      throw new Error('injected process-launch failure');
    }
  }), 'FRA_ROOT_ACCESS_UNAVAILABLE');
  assert.equal(unavailableSpawnCount, 1,
    'an unavailable probe must make exactly one launch attempt');

  process.stdout.write('fra root access refusal tests passed\n');
}

main();

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const lifecycle = require('../src/lib/agent-browser-lifecycle');

const originalWriteFile = fs.writeFile;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFile = fs.appendFile;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
let writes = 0;
let spawns = 0;

fs.writeFile = (...args) => { writes += 1; return originalWriteFile(...args); };
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
fs.appendFile = (...args) => { writes += 1; return originalAppendFile(...args); };
fs.appendFileSync = (...args) => { writes += 1; return originalAppendFileSync(...args); };
childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };

function refusesWithoutEffects(expectedCode, operation) {
  const writesBefore = writes;
  const spawnsBefore = spawns;
  assert.throws(operation, error => {
    assert.equal(error.name, 'AgentBrowserLifecycleError');
    assert.equal(error.code, expectedCode);
    return true;
  });
  assert.equal(writes, writesBefore, `${expectedCode} must not write a file`);
  assert.equal(spawns, spawnsBefore, `${expectedCode} must not spawn a process`);
}

try {
  refusesWithoutEffects('BROWSER_LIFECYCLE_INVALID', () =>
    lifecycle.reconcileBrowserLifecycle({ observation: null }));

  refusesWithoutEffects('BROWSER_LIFECYCLE_ID_INVALID', () =>
    lifecycle.planDownload({
      surfaceKey: 'surface:valid-001',
      ownership: 'agent-owned',
      snapshotRef: `snap_${'a'.repeat(64)}`,
      idempotencyKey: 'download:valid-001',
      downloadId: 'short',
      suggestedName: 'safe.txt'
    }));

  refusesWithoutEffects('BROWSER_LIFECYCLE_MUTATIONS_INVALID', () =>
    lifecycle.reconcileBrowserLifecycle({
      observation: { present: false },
      inFlight: { id: 'mutation:001' }
    }));

  refusesWithoutEffects('BROWSER_LIFECYCLE_SURFACE_INVALID', () =>
    lifecycle.planDownload({ surfaceKey: 'bad key' }));

  refusesWithoutEffects('BROWSER_MEDIA_ARBITRATION_INVALID', () =>
    lifecycle.admitMedia({
      targetKey: 'surface:valid-001',
      idempotencyKey: 'media:valid-001',
      mediaRevision: 0
    }));

  refusesWithoutEffects('BROWSER_OWNERSHIP_INVALID', () =>
    lifecycle.reconcileBrowserLifecycle({
      observation: { present: false, ownership: 'somebody-else' }
    }));

  refusesWithoutEffects('BROWSER_SNAPSHOT_REF_INVALID', () =>
    lifecycle.planDownload({
      surfaceKey: 'surface:valid-001',
      ownership: 'agent-owned',
      snapshotRef: 'snap_not-a-digest'
    }));
} finally {
  fs.writeFile = originalWriteFile;
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFile = originalAppendFile;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
}

console.log('agent browser lifecycle refusal tests passed');

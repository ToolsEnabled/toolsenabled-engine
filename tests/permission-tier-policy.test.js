'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');
const childProcess = require('node:child_process');

const policy = require('../src/lib/permission-tier-policy');

test('malformed sessions refuse before policy work can write, spawn, or inspect a tool', () => {
  const originalWriteFileSync = fs.writeFileSync;
  const originalSpawnSync = childProcess.spawnSync;
  let writes = 0;
  let spawns = 0;
  let toolReads = 0;
  fs.writeFileSync = function countedWrite(...args) {
    writes += 1;
    return originalWriteFileSync.apply(this, args);
  };
  childProcess.spawnSync = function countedSpawn(...args) {
    spawns += 1;
    return originalSpawnSync.apply(this, args);
  };

  const unreadTool = {};
  Object.defineProperties(unreadTool, {
    name: { get() { toolReads += 1; return 'example.mutate'; } },
    effect: { get() { toolReads += 1; return 'local-write'; } }
  });

  try {
    const cases = [
      {
        input: null,
        code: 'PERMISSION_SESSION_UNREADABLE',
        details: {}
      },
      {
        input: { origin: 'sideways', tier: 'guarded' },
        code: 'PERMISSION_ORIGIN_REFUSED',
        details: { origin: 'sideways' }
      },
      {
        input: { origin: 'remote', tier: 'superuser' },
        code: 'PERMISSION_TIER_REFUSED',
        details: { tier: 'superuser' }
      }
    ];

    for (const refusal of cases) {
      assert.throws(
        () => policy.assertToolAllowed(unreadTool, refusal.input),
        error => error instanceof policy.PermissionTierRefusal
          && error.code === refusal.code
          && assert.deepEqual(error.details, refusal.details) === undefined
      );
    }
    assert.equal(toolReads, 0, 'a refused session must stop before tool policy metadata is inspected');
    assert.equal(writes, 0, 'a refused session must not write');
    assert.equal(spawns, 0, 'a refused session must not spawn a process');
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    childProcess.spawnSync = originalSpawnSync;
  }
});

test('a transient manifest read failure is not reported as an invalid binding or cached', () => {
  const manifestPath = require.resolve('../src/lib/fra-capability-manifest');
  const manifest = require(manifestPath);
  const names = ['example.inspect'];
  const binding = {
    allowedToolNames: names,
    allowedToolNamesDigest: manifest.toolNameDigest(names)
  };
  const originalLoad = Module._load;
  let injected = false;

  Module._load = function loadWithOneBusyFailure(request, parent, isMain) {
    if (!injected && request === './fra-capability-manifest'
        && parent?.filename.endsWith('permission-tier-policy.js')) {
      injected = true;
      const error = new Error('device temporarily busy');
      error.code = 'EIO';
      throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    assert.throws(
      () => policy.manifestSession(binding),
      error => error instanceof policy.PermissionTierRefusal
        && error.code === 'PERMISSION_MANIFEST_POLICY_UNREADABLE'
        && error.details.causeCode === 'EIO'
        && /does not claim.*absent or invalid/i.test(error.message)
    );
    assert.equal(injected, true, 'the simulated read failure must reach the lazy manifest require');

    // The failed lookup must not be latched: the same process can decide once
    // the machine answers. Node's legitimate successful module cache remains.
    assert.equal(policy.manifestSession(binding).tier, 'manifest');
    assert.strictEqual(require(manifestPath), manifest,
      'a successfully loaded manifest must retain Node require-cache identity');
  } finally {
    Module._load = originalLoad;
  }
});

test('Guarded sessions admit read effects and refuse write effects', () => {
  const guarded = { origin: 'remote', tier: 'guarded' };
  const localRead = { name: 'example.inspect', effect: 'local-read' };
  const externalRead = { name: 'example.lookup', effect: 'external-read' };
  const localWrite = { name: 'example.change', effect: 'local-write' };

  assert.deepEqual(policy.assertToolAllowed(localRead, guarded), guarded);
  assert.deepEqual(policy.assertToolAllowed(externalRead, guarded), guarded);
  assert.throws(
    () => policy.assertToolAllowed(localWrite, guarded),
    error => error instanceof policy.PermissionTierRefusal
      && error.code === 'PERMISSION_EFFECT_REFUSED'
      && error.details.tool === 'example.change'
      && error.details.effect === 'local-write'
  );
  assert.deepEqual(
    policy.guardedToolNames([localRead, localWrite, externalRead]),
    ['example.inspect', 'example.lookup']
  );
});

test('installation levels resolve to their documented permission sessions', () => {
  assert.deepEqual(policy.installTierSession('guided'), {
    origin: 'local', tier: 'confined', profile: 'read-only'
  });
  assert.deepEqual(policy.installTierSession('standard'), {
    origin: 'local', tier: 'confined', profile: 'workspace'
  });
  assert.deepEqual(policy.installTierSessionFromRecord({ tier: 'unrestricted' }), {
    origin: 'local', tier: 'full'
  });

  assert.throws(
    () => policy.installTierSession('administrator'),
    error => error instanceof policy.PermissionTierRefusal
      && error.code === 'PERMISSION_INSTALL_TIER_REFUSED'
  );
});

test('unrestricted spawn flags require a local Full owner session', () => {
  assert.deepEqual(
    policy.assertUnrestrictedSpawn({ origin: 'local', tier: 'full' }),
    { origin: 'local', tier: 'full' }
  );
  assert.throws(
    () => policy.assertUnrestrictedSpawn({ origin: 'remote', tier: 'guarded' }),
    error => error instanceof policy.PermissionTierRefusal
      && error.code === 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED'
  );
});

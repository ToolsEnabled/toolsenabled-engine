'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../src/lib/proc/hidden-spawn.js');
const source = fs.readFileSync(filename, 'utf8');
const realRequire = createRequire(filename);

// Portable dispatch proof only. Native process proofs are the separate
// root-admission and hidden-spawn-linux-containment tests, never this mock.
function fixture(platform) {
  const log = []; let job = null; let direct = null;
  const exports = {};
  const child = new EventEmitter();
  const context = { module: { exports }, exports, process: { platform, arch: 'x64', env: {}, execPath: process.execPath, cwd: () => __dirname },
    require(name) {
      if (name === 'node:child_process') return { spawn(command, args, options) { log.push('direct-spawn'); direct = options; return child; } };
      if (name === '../providers/subscription-launch-env') return { BILLING_TRIPWIRE: [], safeLaunchEnvironment(value) { log.push('environment'); return { ...value }; } };
      if (name === '../windows-job-control') return { spawnInJob(command, args, options, dependencies) { log.push('wrapper'); job = { options, dependencies }; return child; } };
      if (name === '../linux-process-control') return { spawnLinuxOwned(command, args, options, dependencies) { log.push('wrapper'); job = { options, dependencies }; return child; } };
      return realRequire(name);
    },
  };
  vm.runInNewContext(source, context, { filename });
  return { api: context.module.exports, log, job: () => job, direct: () => direct };
}

test('macOS validates after preparation immediately before direct spawn, never passes private hooks to child options', () => {
  for (const platform of ['darwin']) {
    const f = fixture(platform);
    f.api.spawnHidden('fixture-root', [], { containProcessTree: true, rootLaunch: {
      beforeRootSpawn() { f.log.push('assert-current'); }, spawned() { f.log.push('retained'); },
    } });
    assert.deepEqual(f.log, ['environment', 'assert-current', 'direct-spawn', 'retained']);
    assert.equal(Object.hasOwn(f.direct(), 'rootLaunch'), false);
    const refused = fixture(platform);
    assert.throws(() => refused.api.spawnHidden('fixture-root', [], { containProcessTree: true, rootLaunch: {
      beforeRootSpawn() { throw Object.assign(new Error('revoked'), { code: 'OWNER_HOST_SESSION_REFUSED' }); }, spawned() { assert.fail('no root to retain'); },
    } }), { code: 'OWNER_HOST_SESSION_REFUSED' });
    assert.deepEqual(refused.log, ['environment']);
  }
});

test('Windows and Linux retain the wrapper but validate only at the contained root boundary', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture(platform);
    f.api.spawnHidden('fixture-root', [], { containProcessTree: true, rootLaunch: {
      beforeRootSpawn() { f.log.push('assert-current'); }, spawned() { f.log.push('retained'); },
    } });
    assert.deepEqual(f.log, ['environment', 'wrapper', 'retained']);
    assert.equal(Object.hasOwn(f.job().options, 'rootLaunch'), false);
    f.job().dependencies.beforeRootSpawn();
    assert.equal(f.log.at(-1), 'assert-current');
  }
});

test('a yielding direct-root check is never accepted as synchronous permission', () => {
  const f = fixture('darwin');
  assert.throws(() => f.api.spawnHidden('fixture-root', [], { containProcessTree: true, rootLaunch: {
    beforeRootSpawn: async () => {}, spawned() { assert.fail('no root'); },
  } }), { code: 'HIDDEN_SPAWN_ROOT_GUARD_INVALID' });
  assert.equal(f.direct(), null);
});
